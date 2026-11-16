import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { autosaved, dragPaletteNode } from "./helpers";

/** A complete form-only workflow, also run against the deployed preview. */
export async function verifyGuidedPalette(page: Page) {
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Guided palette acceptance" },
    })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const snapshot = async () => (await page.request.get(endpoint)).json();
  const inspector = page.locator(".inspector");
  const added = async () =>
    (await snapshot()).bundle.flow.nodes.at(-1).id as string;
  const save = (edit: () => Promise<unknown>) => autosaved(page, edit);
  const run = async () => {
    const button = page.getByRole("button", { name: "Run", exact: true });
    await expect(button).toBeEnabled();
    const launched = page.waitForResponse(
      (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
    );
    await button.click();
    const result = await (await launched).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${result.id}`)).json())
            .status,
        { timeout: 30000 },
      )
      .toBe("success");
    await expect(button).toBeEnabled();
  };
  const load = async (filename: string, csv: string) => {
    await dragPaletteNode(page, "Load CSV");
    await expect(
      inspector.getByRole("combobox", { name: /^file/ }),
    ).toHaveValue("");
    await expect(
      inspector.getByRole("combobox", { name: /^file/ }),
    ).toBeEnabled();
    await inspector.getByLabel("Upload file", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await expect(
      inspector.getByRole("combobox", { name: /^file/ }),
    ).toHaveValue(new RegExp(filename.replace(".", "\\.")));
    return added();
  };
  const connect = async (port: string, source: string) =>
    save(() =>
      inspector
        .getByLabel(port, { exact: true })
        .selectOption(`${source}:result`),
    );
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const palette = page.locator(".palette-list");
  for (const name of [
    "Union",
    "Sort",
    "Deduplicate",
    "Calculated columns",
    "Pivot",
    "Unpivot",
    "Sample",
    "Rank",
    "Running total",
    "Export Parquet",
    "Select columns",
    "Clean values",
  ]) {
    const item = palette.getByRole("button", { name, exact: true });
    await expect(item.locator("svg[data-icon]")).toHaveCount(1);
    await expect(item.locator("svg[data-icon]")).not.toHaveAttribute(
      "data-icon",
      "sql",
    );
  }
  const orders = await load(
    "orders.csv",
    "order_id,customer_id,amount,status\n1,1,10,paid\n2,1,20,paid\n3,2,5,refunded\n4,3,7,paid\n",
  );
  const customers = await load(
    "customers.csv",
    "customer_id,region\n1,North\n2,South\n3,West\n",
  );
  await run();
  await dragPaletteNode(page, "Join");
  await connect("left", orders);
  await connect("right", customers);
  await save(async () => {
    await inspector
      .getByRole("button", { name: "Add key pair", exact: true })
      .click();
    await inspector
      .getByRole("combobox", { name: "Left key", exact: true })
      .selectOption("customer_id");
    await inspector
      .getByRole("combobox", { name: "Right key", exact: true })
      .selectOption("customer_id");
  });
  const join = await added();
  await run();
  await expect(inspector).toContainText("right_");
  await dragPaletteNode(page, "Filter");
  await connect("source", join);
  await save(async () => {
    await inspector
      .getByRole("button", { name: "Add condition", exact: true })
      .click();
    await inspector
      .getByRole("combobox", { name: "Column", exact: true })
      .selectOption("status");
    await inspector.getByLabel("Value", { exact: true }).fill("paid");
  });
  const filter = await added();
  await page.goto(`/worktrees/${worktree.id}/flow?node=${filter}`);
  await expect(inspector.getByLabel("Value", { exact: true })).toHaveValue(
    "paid",
  );
  await run();
  await dragPaletteNode(page, "Aggregate");
  await connect("source", filter);
  await save(async () => {
    await inspector
      .getByLabel("Group by columns", { exact: true })
      .selectOption(["region"]);
    await inspector
      .getByRole("button", { name: "Add a measure", exact: true })
      .click();
    const measure = inspector
      .getByRole("region", { name: "measures", exact: true })
      .locator("fieldset")
      .last();
    await measure
      .getByRole("combobox", { name: "Function", exact: true })
      .selectOption("SUM");
    await measure
      .getByRole("combobox", { name: "Column", exact: true })
      .selectOption("amount");
    await measure
      .getByLabel("Output column name", { exact: true })
      .fill("revenue");
  });
  const aggregate = await added();
  await run();
  const result = await (
    await page.request.get(`${endpoint}/preview/${aggregate}?environment=dev`)
  ).json();
  expect(
    result.rows.map((r: { values: unknown[] }) => r.values).sort(),
  ).toEqual([
    ["North", 2, 30],
    ["West", 1, 7],
  ]);
  // Switch an already-configured parameter to the generated SQL without typing SQL.
  await save(() =>
    inspector
      .getByRole("region", { name: "measures", exact: true })
      .getByRole("button", { name: "Advanced SQL", exact: true })
      .click(),
  );
  await expect(
    inspector.getByRole("textbox", { name: /Advanced SQL/ }),
  ).toHaveValue(/SUM\("amount"\)/);
  await dragPaletteNode(page, "Export Parquet");
  await connect("source", aggregate);
  await run();
  await page.getByRole("tab", { name: /^Log/ }).click();
  const download = page
    .getByRole("region", { name: "Download exported data", exact: true })
    .getByRole("button", { name: "Download exported data", exact: true });
  await expect(download).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await download.click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe("export.parquet");
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 4).toString()).toBe("PAR1");
  expect(bytes.subarray(-4).toString()).toBe("PAR1");
  return worktree.id as string;
}
