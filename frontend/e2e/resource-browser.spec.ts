import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dragPaletteNode, signIn } from "./helpers";

/** Grant connections to a new project and open its flow. */
async function projectWith(page: Page, name: string, connections: string[]) {
  const worktree = await (
    await page.request.post("/api/projects", { data: { name } })
  ).json();
  const granted = await page.request.put(
    `/api/projects/${worktree.project}/connections`,
    { data: { connections } },
  );
  expect(granted.ok(), await granted.text()).toBeTruthy();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  return worktree;
}

test("a storage location is browsed to choose a file, a pattern or a folder", async ({
  page,
}, testInfo) => {
  const share = testInfo.outputPath("share");
  mkdirSync(join(share, "inbox", "2024"), { recursive: true });
  for (const name of ["orders.csv", "returns.csv", "labels.parquet"])
    writeFileSync(join(share, name), "id\n1\n");
  writeFileSync(join(share, "inbox", "january.csv"), "id\n2\n");
  writeFileSync(join(share, ".hidden.csv"), "id\n3\n");
  const identity = "share_browser_ui";
  await signIn(page);
  const created = await page.request.put(
    "/api/catalog/connection?create=true",
    {
      data: {
        id: identity,
        name: "Finance share",
        connector: "folder",
        environments: { dev: { root: share }, prod: { root: share } },
      },
    },
  );
  expect(created.ok(), await created.text()).toBeTruthy();
  const worktree = await projectWith(page, "Browsed files", [identity]);
  try {
    await dragPaletteNode(page, "Load CSV");
    const inspector = page.locator(".inspector");
    await inspector
      .getByRole("combobox", { name: "Location", exact: true })
      .selectOption(identity);
    const browse = inspector.getByRole("button", { name: "Browse" });
    await browse.click();
    const dialog = page.getByRole("dialog", { name: "Choose a file" });
    const options = dialog.getByRole("option");
    // Folders, then a pattern over the files a reader can take together, then
    // the files; hidden files are not offered.
    await expect(options).toHaveText([
      /^inbox/,
      /^All CSV files\*\.csv2 files/,
      /^labels\.parquet/,
      /^orders\.csv/,
      /^returns\.csv/,
    ]);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await testInfo.attach("file-browser", {
      body: await dialog.screenshot(),
      contentType: "image/png",
    });
    // Typing filters the level; Enter chooses the active entry.
    const filter = dialog.getByRole("combobox", { name: "Filter this folder" });
    await filter.fill("ord");
    await expect(options).toHaveText([/^orders\.csv/]);
    await filter.press("Enter");
    await expect(dialog).toHaveCount(0);
    const file = inspector.getByRole("textbox", { name: /^file/ });
    await expect(file).toHaveValue("orders.csv");

    // The chosen file is marked; a folder is opened, and Backspace goes back up.
    await browse.click();
    await expect(
      dialog.getByRole("option", { name: /^orders\.csv/ }),
    ).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("option", { name: /^inbox/ }).click();
    await expect(
      dialog.getByRole("navigation", { name: "Path" }).getByRole("button"),
    ).toHaveText(["Finance share", "inbox"]);
    await expect(options).toHaveText([/^2024/, /^january\.csv/]);
    await filter.press("Backspace");
    await expect(options.first()).toHaveText(/^inbox/);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("option", { name: /^All CSV files/ }).click();
    await expect(file).toHaveValue("*.csv");

    // A folder itself can be chosen, for readers of a table folder.
    await browse.click();
    await dialog.getByRole("option", { name: /^inbox/ }).click();
    await dialog.getByRole("button", { name: "Use this folder" }).click();
    await expect(file).toHaveValue("inbox");
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    await page.request.delete(`/api/catalog/connection/${identity}`);
  }
});

test("a table is found across the schemas of a database and chosen at once", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const database = testInfo.outputPath("warehouse.duckdb");
  execFileSync("../.venv/bin/python", [
    "-c",
    [
      "import duckdb, sys",
      "with duckdb.connect(sys.argv[1]) as db:",
      "    for schema in ('sales', 'finance'):",
      "        db.execute(f'CREATE SCHEMA {schema}')",
      "    db.execute('CREATE TABLE sales.orders AS SELECT 1 AS id')",
      "    db.execute('CREATE TABLE sales.totals AS SELECT 2 AS id')",
      "    db.execute('CREATE TABLE finance.ledger AS SELECT 3 AS id')",
      "    db.execute('CREATE VIEW finance.monthly_totals AS SELECT 4 AS id')",
    ].join("\n"),
    database,
  ]);
  const connector = {
    id: "attached_browser_ui",
    name: "Attached DuckDB browser",
    family: "database",
    parameters: [{ name: "database", type: "text" }],
    capabilities: ["read"],
    init_sql: "ATTACH {{ database }} AS {{ alias }};",
  };
  const identity = "warehouse_browser_ui";
  await signIn(page);
  expect(
    (
      await page.request.put("/api/catalog/connector", { data: connector })
    ).ok(),
  ).toBeTruthy();
  const created = await page.request.put(
    "/api/catalog/connection?create=true",
    {
      data: {
        id: identity,
        name: "Warehouse",
        connector: connector.id,
        environments: { dev: { database }, prod: { database } },
      },
    },
  );
  expect(created.ok(), await created.text()).toBeTruthy();
  const worktree = await projectWith(page, "Browsed tables", [identity]);
  try {
    await dragPaletteNode(page, "Load table");
    const inspector = page.locator(".inspector");
    await inspector
      .getByRole("combobox", { name: "connection", exact: true })
      .selectOption(identity);
    await inspector.getByRole("button", { name: "Browse" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose a table" });
    const options = dialog.getByRole("option");
    await expect(options).toHaveText([
      /^finance2 tables/,
      /^main0 tables/,
      /^sales2 tables/,
    ]);
    // A search reaches every schema, and the schema of each match is shown.
    await dialog
      .getByRole("combobox", { name: "Search the tables of every schema" })
      .fill("tot");
    await expect(options).toHaveText([
      /^finance\.monthly_totalsview/,
      /^sales\.totals/,
    ]);
    await testInfo.attach("table-browser", {
      body: await dialog.screenshot(),
      contentType: "image/png",
    });
    await dialog.getByRole("option", { name: /^sales\.totals/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      inspector.getByRole("combobox", { name: "schema", exact: true }),
    ).toHaveValue("sales");
    await expect(
      inspector.getByRole("combobox", { name: "table", exact: true }),
    ).toHaveValue("totals");
    await expect(inspector.locator(".source-sample td")).toHaveText(["2"]);
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    await page.request.delete(`/api/catalog/connection/${identity}`);
    await page.request.delete(`/api/catalog/connector/${connector.id}`);
  }
});
