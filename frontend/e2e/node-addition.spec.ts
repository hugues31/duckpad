import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";

async function prepare(page: Page) {
  await signIn(page);
  const project = await page.request.post("/api/projects", {
    data: { name: "Pending node addition" },
  });
  expect(project.ok()).toBe(true);
  const { id } = await project.json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    {
      id: "existing",
      label: "Existing node",
      template: "sql",
      params: {},
      position: { x: 0, y: 0 },
    },
  ];
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
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${id}/flow?node=existing`);
  await expect(displayName(page)).toHaveValue("Existing node");
  return { endpoint, existing: bundle.flow.nodes[0] };
}

const displayName = (page: Page) =>
  page.getByRole("textbox", { name: "Display name", exact: true });
const adding = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Adding node…" });

async function delaySave(page: Page, endpoint: string, fail = false) {
  const writes: Snapshot["bundle"][] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes.push(route.request().postDataJSON().bundle);
    if (writes.length === 1) {
      // Reproduce the window in which edits used to target the previous node.
      await Promise.all([
        new Promise((resolve) => setTimeout(resolve, 2000)),
        held,
      ]);
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: "Temporary node creation failure" },
        });
    }
    await route.continue();
  });
  return { writes, release };
}

async function expectPending(page: Page) {
  await expect(adding(page)).toBeVisible();
  await expect(
    page.locator(".palette").getByRole("button", { name: "SQL", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .locator(".palette")
      .getByRole("button", { name: "Filter", exact: true }),
  ).toBeDisabled();
  // Inert panels remove the previous editor from keyboard and pointer access,
  // while preserving its draft until the save succeeds or fails.
  await expect(page.locator("#node-inspector")).toHaveAttribute("inert", "");
  const previousName = page.locator(".inspector input").first();
  await previousName.evaluate((element: HTMLInputElement) => element.focus());
  await expect(previousName).not.toBeFocused();
  await page.keyboard.type("Name typed during creation");
  await page.keyboard.press("Tab");
  // Canvas delete keys listen on the document, outside the inert panels.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await expect(previousName).toHaveValue("Existing node");
}

const additions = [
  { name: "SQL node", button: "SQL" },
  { name: "template copy", button: "Filter" },
  { name: "linked node", button: "Add linked: Filter" },
  { name: "component", button: "Reusable branch" },
  { name: "dropped template", button: "Filter", drop: true },
  {
    name: "duplicated node",
    button: "Duplicate node",
    panel: "#node-inspector",
    label: "Existing node",
  },
];

for (const addition of additions) {
  test(`a delayed ${addition.name} addition prevents editing the previous node`, async ({
    page,
  }) => {
    const { endpoint, existing } = await prepare(page);
    const { writes, release } = await delaySave(page, endpoint);
    const button = page
      .locator(addition.panel ?? ".palette")
      .getByRole("button", {
        name: addition.button,
        exact: true,
      });
    if (addition.drop)
      await button.dragTo(page.locator(".react-flow__pane"), {
        targetPosition: { x: 650, y: 350 },
      });
    else await button.click();
    try {
      await expectPending(page);
    } finally {
      release();
    }
    await expect(adding(page)).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(displayName(page)).toBeEditable();
    await expect(displayName(page)).toHaveValue(addition.label ?? "");
    expect(writes).toHaveLength(1);
    const created = writes[0]!.flow.nodes.find(
      (node) => node.id !== existing.id,
    )!;
    await expect(
      page.locator(`.react-flow__node[data-id="${created.id}"]`),
    ).toHaveClass(/selected/);
    await displayName(page).fill("Revenue report");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(endpoint) &&
        response.request().method() === "PUT",
    );
    await displayName(page).press("Tab");
    expect((await saved).ok()).toBe(true);
    await page.reload();
    const after: Snapshot = await (await page.request.get(endpoint)).json();
    expect(
      after.bundle!.flow.nodes.find((node) => node.id === existing.id),
    ).toEqual(existing);
    expect(
      after.bundle!.flow.nodes.find((node) => node.id === created.id)?.label,
    ).toBe("Revenue report");
    expect(after.bundle!.flow.nodes).toHaveLength(2);
    expect(writes).toHaveLength(2);
  });
}

test("a failed addition restores the inspector and allows retrying", async ({
  page,
}) => {
  const { endpoint, existing } = await prepare(page);
  const { writes, release } = await delaySave(page, endpoint, true);
  await page
    .locator(".palette")
    .getByRole("button", { name: "SQL", exact: true })
    .click();
  try {
    await expectPending(page);
  } finally {
    release();
  }
  await expect(
    page.getByText("Temporary node creation failure", { exact: true }),
  ).toBeVisible();
  await expect(adding(page)).toHaveCount(0);
  await expect(displayName(page)).toBeEditable();
  await expect(displayName(page)).toHaveValue("Existing node");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  const after: Snapshot = await (await page.request.get(endpoint)).json();
  expect(after.bundle!.flow.nodes).toEqual([existing]);
  await page
    .locator(".palette")
    .getByRole("button", { name: "SQL", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(displayName(page)).toBeEditable();
  await expect(displayName(page)).toHaveValue("");
  expect(writes).toHaveLength(2);
});
