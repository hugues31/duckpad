import { expect, type Page } from "@playwright/test";

/** The same synthetic form workflow is also used to verify a deployed preview. */
export async function verifyDataPreparation(page: Page) {
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Data preparation forms" },
    })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const snapshot = async () => (await page.request.get(endpoint)).json();
  const inspector = page.locator(".inspector");
  const nodeId = async (template: string) =>
    (await snapshot()).bundle.flow.nodes.find(
      (node: any) => node.template === template,
    ).id;
  const save = async () => {
    await inspector
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Unsaved changes", { exact: true }),
    ).toHaveCount(0);
  };
  const run = async (status = "success") => {
    await expect(
      page.getByRole("button", { name: "Run pipeline", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
      { timeout: 30000 },
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    const result = await (await launched).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${result.id}`)).json())
            .status,
        { timeout: 30000 },
      )
      .toBe(status);
    await expect(
      page.getByRole("button", { name: "Run pipeline", exact: true }),
    ).toBeEnabled({ timeout: 30000 });
    return (await page.request.get(`/api/runs/${result.id}`)).json();
  };
  const add = async (name: string, source: string) => {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(inspector.locator(".inspector-title")).toContainText(name);
    await inspector
      .getByLabel("source", { exact: true })
      .selectOption(`${source}:result`);
    await expect
      .poll(async () =>
        (await snapshot()).bundle.flow.edges.some(
          (edge: any) => edge.source === source,
        ),
      )
      .toBe(true);
  };
  const selectNode = async (id: string) => {
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  };
  const rows = () => inspector.locator(".preparation-row");
  const addColumn = async (source: string) => {
    await inspector
      .getByRole("button", { name: "Add column", exact: true })
      .click();
    const row = rows().last();
    await row.getByLabel("Source column", { exact: true }).selectOption(source);
    return row;
  };
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page.getByRole("button", { name: "Load CSV", exact: true }).click();
  await inspector.getByLabel("Upload file", { exact: true }).setInputFiles({
    name: "preparation.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "id,amount,day,other\n 001 ,,31/12/2026,keep\n 002 ,12,,also\n",
    ),
  });
  await expect(inspector.getByRole("textbox", { name: /file/ })).toHaveValue(
    /preparation\.csv$/,
  );
  await inspector
    .getByRole("textbox", { name: /types/ })
    .fill('{"id":"VARCHAR","day":"VARCHAR","amount":"BIGINT"}');
  await save();
  await expect
    .poll(async () => (await snapshot()).bundle.flow.nodes[0].params.types)
    .toContain("VARCHAR");
  await run();
  const source = await nodeId("load_csv");
  await add("Clean values", source);
  await expect(
    inspector.getByRole("button", { name: "Add column", exact: true }),
  ).toBeEnabled();
  let row = await addColumn("id");
  await row.getByLabel("Trim text", { exact: true }).check();
  row = await addColumn("amount");
  await row.getByLabel("Replace nulls", { exact: true }).check();
  await row.getByLabel("Replacement value", { exact: true }).fill("0");
  row = await addColumn("day");
  await row.getByLabel("Parse date", { exact: true }).check();
  await row.getByLabel("Date format", { exact: true }).fill("%d/%m/%Y");
  await row.getByLabel("Replace nulls", { exact: true }).check();
  await row.getByLabel("Replacement value", { exact: true }).fill("2000-01-01");
  await save();
  await expect
    .poll(
      async () =>
        (await snapshot()).bundle.flow.nodes.find(
          (node: any) => node.template === "clean_values",
        ).params.columns,
    )
    .toEqual([
      { source: "id", trim: true },
      { source: "amount", replacement: "0" },
      { source: "day", date_format: "%d/%m/%Y", replacement: "2000-01-01" },
    ]);
  await run();
  const clean = await nodeId("clean_values");
  const cleaned = await (
    await page.request.get(`${endpoint}/preview/${clean}?environment=dev`)
  ).json();
  expect(cleaned.rows.map((row: any) => row.values)).toEqual([
    ["001", 0, "2026-12-31", "keep"],
    ["002", 12, "2000-01-01", "also"],
  ]);
  await add("Select columns", clean);
  await inspector
    .getByRole("button", { name: "Use all columns", exact: true })
    .click();
  await expect(rows()).toHaveCount(4);
  await rows()
    .nth(3)
    .getByRole("button", { name: "Drop column", exact: true })
    .click();
  await rows().nth(0).getByLabel("Output name", { exact: true }).fill("key");
  await rows().nth(1).getByLabel("Output name", { exact: true }).fill("KEY");
  await expect(
    inspector.getByText("Output names must be unique, ignoring letter case."),
  ).toHaveCount(2);
  await rows().nth(1).getByLabel("Output name", { exact: true }).fill("total");
  await rows()
    .nth(1)
    .getByLabel("Output type", { exact: true })
    .selectOption("DOUBLE");
  await rows().nth(2).getByLabel("Output name", { exact: true }).fill("date");
  await rows()
    .nth(2)
    .getByRole("button", { name: "Move up", exact: true })
    .click();
  await rows()
    .nth(1)
    .getByRole("button", { name: "Move up", exact: true })
    .click();
  await save();
  const selection = await nodeId("select_columns");
  const expected = [
    { source: "day", name: "date" },
    { source: "id", name: "key" },
    { source: "amount", name: "total", type: "DOUBLE" },
  ];
  await expect
    .poll(
      async () =>
        (await snapshot()).bundle.flow.nodes.find(
          (node: any) => node.id === selection,
        ).params.columns,
    )
    .toEqual(expected);
  await page.reload();
  await selectNode(selection);
  await expect(rows()).toHaveCount(3);
  await expect(
    rows().nth(0).getByLabel("Output name", { exact: true }),
  ).toHaveValue("date");
  await expect(
    rows().nth(2).getByLabel("Output type", { exact: true }),
  ).toHaveValue("DOUBLE");
  await selectNode(clean);
  await expect(
    rows().nth(0).getByLabel("Trim text", { exact: true }),
  ).toBeChecked();
  await expect(
    rows().nth(2).getByLabel("Replacement value", { exact: true }),
  ).toHaveValue("2000-01-01");
  await add("Filter", selection);
  await inspector
    .getByRole("textbox", { name: /condition/ })
    .fill('"total" >= 0');
  await save();
  await run();
  const filtered = await nodeId("filter");
  const result = await (
    await page.request.get(`${endpoint}/preview/${filtered}?environment=dev`)
  ).json();
  expect(
    result.columns.map((column: any) => [column.name, column.type]),
  ).toEqual([
    ["date", "DATE"],
    ["key", "VARCHAR"],
    ["total", "DOUBLE"],
  ]);
  expect(result.rows.map((row: any) => row.values)).toEqual([
    ["2026-12-31", "001", 0],
    ["2000-01-01", "002", 12],
  ]);
  await selectNode(selection);
  await expect(page.locator(".preview-panel")).toContainText("2026-12-31");
  // Conversion errors must retain stale results and block downstream work.
  await rows()
    .nth(1)
    .getByLabel("Output type", { exact: true })
    .selectOption("DATE");
  await save();
  const failure = await run("partial_failure");
  expect(failure.nodes[selection].error).toContain("Conversions must be valid");
  expect(failure.nodes[filtered].status).toBe("blocked");
  await rows()
    .nth(1)
    .getByLabel("Output type", { exact: true })
    .selectOption("");
  await save();
  await run();
  return { worktree: worktree.id, selection, endpoint };
}
