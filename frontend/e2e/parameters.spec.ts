import { expect, test, type Page } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";
import type { Snapshot } from "../src/types";

async function prepare(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Parameter editing" },
    })
  ).json();
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot: Snapshot = await (await page.request.get(url)).json();
  const bundle = snapshot.bundle!;
  bundle.templates.parameters = `-- @label Parameter values
-- @param amount: number = 42
-- @param cities: list<text> = ["London"]
-- @output result
SELECT {{ amount }} AS amount, [{{ cities }}] AS cities;`;
  bundle.components.parameters = {
    id: "parameters",
    name: "Component parameters",
    nodes: [
      {
        id: "inner",
        template: "parameters",
        params: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    inputs: {},
    outputs: { result: { node: "inner", port: "result" } },
    parameters: {
      amount: {
        type: "number",
        default: 84,
        targets: [{ node: "inner", param: "amount" }],
      },
      cities: {
        type: "list<text>",
        default: ["Oslo"],
        targets: [{ node: "inner", param: "cities" }],
      },
    },
  };
  bundle.flow.nodes = [
    {
      id: "template",
      template: "parameters",
      params: { amount: 7 },
      position: { x: 0, y: 0 },
    },
    {
      id: "component",
      component: "parameters",
      params: { amount: 7 },
      position: { x: 350, y: 0 },
    },
  ];
  bundle.flow.edges = [];
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${worktree.id}/flow`);
  return url;
}

async function save(page: Page, url: string, action: () => Promise<void>) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith(url) && r.request().method() === "PUT",
  );
  await action();
  expect((await response).ok()).toBe(true);
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  return (await (await page.request.get(url)).json()) as Snapshot;
}

for (const [node, defaultAmount] of [
  ["template", 42],
  ["component", 84],
] as const) {
  test(`${node} parameters preserve drafts and restore numeric defaults`, async ({
    page,
  }) => {
    const url = await prepare(page);
    await page.locator(`.react-flow__node[data-id="${node}"]`).click();
    const inspector = page.locator(".inspector");
    const amount = inspector.getByRole("textbox", { name: /amount/ });
    const cities = inspector.getByRole("textbox", { name: /cities/ });
    const params = (snapshot: Snapshot) =>
      snapshot.bundle!.flow.nodes.find((item) => item.id === node)!.params;

    // Edits are saved after a pause in typing; the field shows the default once left.
    let snapshot = await save(page, url, () => amount.fill(""));
    expect(params(snapshot)).not.toHaveProperty("amount");
    await expect(amount).toHaveValue("");
    await amount.blur();
    await expect(amount).toHaveValue(String(defaultAmount));
    const compiled = await (
      await page.request.get(`${url}/compile/${node}?environment=dev`)
    ).json();
    expect(compiled[0].bindings.amount).toBe(defaultAmount);

    snapshot = await save(page, url, async () => {
      await amount.fill("");
      await amount.pressSequentially("-");
      await expect(amount).toHaveValue("-");
      await amount.pressSequentially("12.50");
      await expect(amount).toHaveValue("-12.50");
      await amount.blur();
    });
    expect(params(snapshot).amount).toBe(-12.5);

    snapshot = await save(page, url, async () => {
      await amount.fill("");
      await amount.pressSequentially("1e-3");
      await expect(amount).toHaveValue("1e-3");
      await amount.blur();
    });
    expect(params(snapshot).amount).toBe(0.001);

    snapshot = await save(page, url, () => amount.fill("0"));
    expect(params(snapshot).amount).toBe(0);
    snapshot = await save(page, url, () => amount.fill(""));
    expect(params(snapshot)).not.toHaveProperty("amount");

    snapshot = await save(page, url, async () => {
      await cities.fill("");
      await cities.pressSequentially("New York, Paris");
      await expect(cities).toHaveValue("New York, Paris");
    });
    expect(params(snapshot).cities).toEqual(["New York", "Paris"]);
    await page.reload();
    await page.locator(`.react-flow__node[data-id="${node}"]`).click();
    await expect(cities).toHaveValue("New York, Paris");
    await expect(amount).toHaveValue(String(defaultAmount));

    const run = await (
      await page.request.post(`${url}/runs`, {
        data: { environment: "dev", node },
      })
    ).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      )
      .toBe("success");
    const preview = await (
      await page.request.get(
        `${url}/preview/${node}?environment=dev&port=result`,
      )
    ).json();
    expect(
      preview.rows.map((row: { values: unknown[] }) => row.values),
    ).toEqual([[defaultAmount, ["New York", "Paris"]]]);
  });
}

test("navigation keeps an incomplete numeric Inspector draft until it is corrected", async ({
  page,
}) => {
  const url = await prepare(page);
  await page.locator('.react-flow__node[data-id="template"]').click();
  const amount = page
    .locator(".inspector")
    .getByRole("textbox", { name: /amount/ });
  const before: Snapshot = await (await page.request.get(url)).json();
  await amount.fill("-");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  await page.getByRole("link", { name: "Code", exact: true }).click();
  const guard = page.getByRole("dialog", {
    name: "Unsaved changes",
    exact: true,
  });
  await expect(guard).toContainText("Enter a finite number.");
  await guard
    .getByRole("button", { name: "Stay on this page", exact: true })
    .click();
  await expect(amount).toHaveValue("-");
  expect((await (await page.request.get(url)).json()).revision).toBe(
    before.revision,
  );
  await amount.fill("12.5");
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await expect(page).toHaveURL(/\/code(\?|$)/);
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  const saved: Snapshot = await (await page.request.get(url)).json();
  expect(
    saved.bundle!.flow.nodes.find((node) => node.id === "template")!.params
      .amount,
  ).toBe(12.5);
});

test("clearing a required number does not save zero and invalid drafts stay editable", async ({
  page,
}) => {
  const url = await prepare(page);
  const before: Snapshot = await (await page.request.get(url)).json();
  const bundle = before.bundle!;
  bundle.templates.parameters = bundle.templates.parameters.replace(
    "number = 42",
    "number",
  );
  expect(
    (
      await page.request.put(url, {
        data: { revision: before.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.locator('.react-flow__node[data-id="template"]').click();
  const amount = page
    .locator(".inspector")
    .getByRole("textbox", { name: /amount/ });
  for (const invalid of ["-", "not a number", "1e999"]) {
    await amount.fill(invalid);
    await amount.blur();
    await expect(amount).toHaveValue(invalid);
    await expect(amount).toHaveJSProperty(
      "validationMessage",
      "Enter a finite number.",
    );
    const stored: Snapshot = await (await page.request.get(url)).json();
    expect(stored.bundle!.flow.nodes[0].params.amount).toBe(7);
  }
  const stored = await save(page, url, () => amount.fill(""));
  expect(stored.bundle!.flow.nodes[0].params).not.toHaveProperty("amount");
  await expect(amount).toHaveValue("");
  const compiled = await page.request.get(
    `${url}/compile/template?environment=dev`,
  );
  expect(compiled.ok()).toBe(false);
  expect(await compiled.text()).toContain("Parameter amount is required");
});

test("connection numbers use defaults after clearing and commit focused drafts on submit", async ({
  page,
}) => {
  await signIn(page);
  const id = `parameter_port_${Date.now()}`;
  expect(
    (
      await page.request.put("/api/catalog/connector", {
        data: {
          id,
          name: "Numeric connector",
          family: "database",
          parameters: [{ name: "port", type: "number", default: 5432 }],
          extensions: [],
          capabilities: ["read"],
          init_sql: "",
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.put("/api/catalog/connection?create=true", {
        data: {
          id,
          name: "Numeric connection",
          connector: id,
          environments: { dev: { port: 6543 }, prod: { port: 9876 } },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await openInstanceSettings(page, "Connections");
  const card = page.getByRole("button", { name: /Numeric connection/ });
  await card.click();
  const dialog = page.getByRole("dialog");
  const port = dialog.getByRole("textbox", { name: "port", exact: true });
  await port.fill("");
  await expect(port).toHaveValue("");
  await port.blur();
  await expect(port).toHaveValue("5432");
  await dialog.getByRole("button", { name: "prod", exact: true }).click();
  await expect(port).toHaveValue("9876");
  await dialog.getByRole("button", { name: "dev", exact: true }).click();
  await expect(port).toHaveValue("5432");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const connection = async () =>
    (
      await (await page.request.get("/api/workspace")).json()
    ).catalog.connections.find((item: { id: string }) => item.id === id);
  expect((await connection()).environments).toEqual({
    dev: {},
    prod: { port: 9876 },
  });
  await card.click();
  await expect(port).toHaveValue("5432");
  await port.fill("");
  await port.pressSequentially("-12.50");
  await expect(port).toHaveValue("-12.50");
  await port.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect((await connection()).environments.dev.port).toBe(-12.5);
  await card.click();
  await port.fill("");
  await port.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect((await connection()).environments.dev).not.toHaveProperty("port");
  await card.click();
  await port.fill("1e999");
  await port.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(port).toHaveValue("1e999");
  await port.fill("0");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect((await connection()).environments.dev.port).toBe(0);
});
