import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { dragPaletteNode } from "./helpers";

/** Exercise definition browsing and placement locally or on an authenticated preview. */
export async function verifyPaletteDetails(page: Page) {
  const response = await page.request.post("/api/example", { data: {} });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const endpoint = `/api/worktrees/${id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  let snapshot = await read();
  const code = `-- @label Review transform
-- @description Compare two inputs using the declared parameters.
-- @input left
-- @input right
-- @param enabled: boolean = false
-- @param threshold: number = 0
-- @param note: text = ""
-- @param fields: list<text> = ["amount", "region"]
-- @param optional: text = null
-- @param required: text
-- @output result
SELECT * FROM {{ left }};
-- @output second
SELECT * FROM {{ right }};`;
  snapshot.bundle!.templates.review_transform = code;
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBe(true);
  const before = await read();
  await page.goto(`/worktrees/${id}/flow?node=orders`);
  await expect(
    page.locator(".inspector").getByLabel("Display name", { exact: true }),
  ).toBeVisible();
  const palette = page.locator(".palette-list");
  const details = page.getByRole("complementary", {
    name: "Node type details",
    exact: true,
  });
  const item = palette.getByRole("button", {
    name: "Review transform",
    exact: true,
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (["PUT", "POST", "DELETE"].includes(request.method()))
      writes.push(request.url());
  });
  await item.hover();
  await expect(details).toHaveCount(0);
  await item.click();
  await item.click();
  await item.focus();
  await item.press("Enter");
  await item.press("Space");
  await expect(item).toHaveAttribute("aria-pressed", "true");
  await expect(details).toContainText(
    "Compare two inputs using the declared parameters.",
  );
  await expect(
    details.getByRole("region", { name: "Inputs", exact: true }).locator("li"),
  ).toHaveText(["left", "right"]);
  await expect(
    details.getByRole("region", { name: "outputs", exact: true }).locator("li"),
  ).toHaveText(["result", "second"]);
  const parameters = details.locator(".palette-parameters > div");
  await expect(parameters).toHaveCount(6);
  for (const [index, value] of [
    "false",
    "0",
    '""',
    '["amount","region"]',
    "null",
  ].entries()) {
    await expect(parameters.nth(index).locator("dd code")).toHaveText(value);
  }
  await expect(parameters.last()).toContainText("No default value");
  await expect(details.locator("input, textarea, select")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(
    before.bundle!.flow.nodes.length,
  );
  expect((await read()).revision).toBe(before.revision);
  expect(writes).toEqual([]);

  // Close returns to the selected instance; selecting a canvas node also leaves browsing.
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(item).toBeFocused();
  await expect(
    page.locator(".inspector").getByLabel("Display name", { exact: true }),
  ).toBeVisible();
  await palette.getByRole("button", { name: "Load CSV", exact: true }).click();
  await expect(details).toContainText("No inputs.");
  await expect(details).toContainText(
    before.parsed_templates.load_csv.description!,
  );
  await palette
    .getByRole("button", { name: "Export CSV", exact: true })
    .click();
  await expect(details).toContainText("No outputs.");
  await palette.getByRole("button", { name: "SQL", exact: true }).click();
  await expect(details).toContainText("No parameters.");
  await palette
    .getByRole("button", { name: "Regional report", exact: true })
    .click();
  await expect(details).toContainText(
    before.bundle!.components.regional_report.description!,
  );
  await expect(
    details.getByRole("region", { name: "Inputs", exact: true }).locator("li"),
  ).toHaveText(["orders"]);
  await expect(
    details.getByRole("region", { name: "outputs", exact: true }).locator("li"),
  ).toHaveText(["orders", "report"]);
  await expect(details.locator(".palette-parameters")).toContainText(
    "condition",
  );
  expect((await read()).commit).toBe(before.commit);
  expect(writes).toEqual([]);

  // The open panel follows edits to the definition, rather than a copied catalog entry.
  await item.click();
  snapshot = await read();
  snapshot.bundle!.templates.review_transform = code.replace(
    "Compare two inputs using the declared parameters.",
    "Updated definition description.",
  );
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBe(true);
  await expect(details).toContainText("Updated definition description.");
  await details.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await item.click();
  await dragPaletteNode(page, "Review transform");
  await expect(page.locator(".react-flow__node")).toHaveCount(
    before.bundle!.flow.nodes.length + 1,
  );
  await expect(details).toHaveCount(0);
  const after = await read();
  const added = after.bundle!.flow.nodes.at(-1)!;
  expect(added.origin).toBe("review_transform");
  await expect(
    page.locator(`.react-flow__node[data-id="${added.id}"]`),
  ).toHaveClass(/selected/);
  await expect(
    page.locator(".inspector").getByLabel("Display name", { exact: true }),
  ).toBeVisible();
  await item.click();
  await page
    .locator(`.react-flow__node[data-id="${added.id}"] .node-shape`)
    .click();
  await expect(details).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(
    before.bundle!.flow.nodes.length + 1,
  );
  return id as string;
}
