import { expect, test } from "@playwright/test";
import { codeSaved, openCode, signIn } from "./helpers";
import type { Run, Snapshot, Statuses } from "../src/types";

const ORDERS = Array.from(
  { length: 300 },
  (_, index) => `(${index + 1}, '${["FR", "DE", "PT"][index % 3]}')`,
).join(", ");

test("edit a node's code, preview it on input samples, fix it and preview again", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Code previews" },
  });
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    { id: "orders", label: "Orders", position: { x: 0, y: 0 }, params: {} },
    {
      id: "countries",
      label: "Countries",
      position: { x: 300, y: 0 },
      params: {},
    },
  ];
  bundle.flow.edges = [
    {
      id: "edge",
      source: "orders",
      sourceHandle: "result",
      target: "countries",
      targetHandle: "source",
    },
  ];
  const code =
    "-- @input source\n-- @output result\nSELECT country, count(*) AS orders\nFROM {{ source }}\nGROUP BY ALL\nORDER BY country;\n";
  bundle.node_sql = {
    "nodes/orders.sql": `-- @output result\nSELECT * FROM (VALUES ${ORDERS}) AS orders(id, country);\n`,
    "nodes/countries.sql": code,
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  const runs = async () =>
    (
      (await (
        await page.request.get(`/api/runs?worktree=${id}`)
      ).json()) as Run[]
    ).length;
  const statuses = async () =>
    (
      (await (
        await page.request.get(`${endpoint}/status?environment=dev`)
      ).json()) as Statuses
    ).nodes;

  await page.goto(`/worktrees/${id}/flow?node=countries`);
  const panel = await openCode(page);
  const results = page.getByRole("region", { name: "Results", exact: true });
  // The canvas stays in view beside the docked code.
  await expect(
    page.locator('.react-flow__node[data-id="orders"]'),
  ).toBeVisible();
  const columns = panel.getByRole("region", { name: "Input columns" });
  const country = columns.getByRole("button", {
    name: "country VARCHAR",
    exact: true,
  });
  // Nothing ran on this branch yet: the columns come with the first results.
  await expect(columns).toContainText("Run the ancestors to see its columns");

  // The input has no result yet: the preview asks to run the ancestors.
  await panel.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  const preview = results.locator(".draft-preview");
  await expect(
    results.getByRole("tab", { name: "Preview", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(preview).toContainText("These inputs have no results yet");
  await preview.getByRole("button", { name: "Run ancestors" }).click();
  // Once they ran, the preview computes again by itself.
  const table = preview.locator(".data-table");
  await expect(table.locator("tbody tr")).toHaveCount(3, { timeout: 30000 });
  await expect(table.locator("tbody tr").first()).toContainText(/DE\s*100/);
  await expect(preview).toContainText(
    "Computed from the first 1,000 rows of each input",
  );
  await expect(columns).toContainText("Last result");
  await expect(country).toBeVisible();
  const recorded = await runs();
  expect(recorded).toBe(1);
  const before = await statuses();
  expect(before.orders.outputs.result.status).toBe("valid");
  expect(before.countries).toBeUndefined();

  // A typo fails the preview where it is, without saving anything to run.
  await codeSaved(page, async () => {
    await panel.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(
      code.replace("country, count", "countryy, count"),
    );
  });
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(preview.getByRole("alert")).toContainText(
    'Line 3: Binder Error: Referenced column "countryy" not found',
  );
  await expect(panel.locator(".squiggly-error")).not.toHaveCount(0);

  // Fix it from the input columns, on a smaller sample, and preview again.
  await panel.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(
    "-- @input source\n-- @output result\nSELECT , count(*) AS orders\nFROM {{ source }}\nGROUP BY ALL\nORDER BY 1;\n",
  );
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  for (let index = 0; index < "count(*) AS orders".length + 2; index++)
    await page.keyboard.press("ArrowLeft");
  await country.click();
  await panel
    .getByRole("combobox", { name: "Rows read from each input" })
    .selectOption("100");
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(preview).toContainText(
    "Computed from the first 100 rows of each input",
  );
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(panel.locator(".squiggly-error")).toHaveCount(0);
  // The first 100 rows hold 34 French orders.
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").nth(1)).toContainText(/FR\s*34/);

  // Previews recorded no run and changed no result or status.
  expect(await runs()).toBe(recorded);
  await expect.poll(statuses).toEqual(before);
});
