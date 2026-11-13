import { dragPaletteNode } from "./helpers";
import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import pt from "../src/locales/pt.json" with { type: "json" };
import de from "../src/locales/de.json" with { type: "json" };

/** Exercise node creation on a local instance or an authenticated preview. */
export async function verifyNodeCreation(page: Page) {
  const response = await page.request.post("/api/projects", {
    data: { name: "Node creation review" },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const endpoint = `/api/worktrees/${id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  const snapshot = await read();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    {
      id: "source",
      label: "Sample rows",
      params: {},
      position: { x: 0, y: 0 },
    },
  ];
  bundle.node_sql = {
    "nodes/source.sql": "-- @output result\nSELECT 42 AS amount;",
  };
  bundle.templates.project_summary =
    "-- @label Project summary\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${id}/flow`);
  const palette = page.locator(".palette");
  const inspector = page.locator(".inspector");
  await dragPaletteNode(page, "SQL");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  const created = (await read()).bundle!.flow.nodes.at(-1)!;
  const sql = page.locator(`.react-flow__node[data-id="${created.id}"]`);
  const source = page.locator('.react-flow__node[data-id="source"]');
  await expect(sql.locator(".missing-input")).toHaveAttribute(
    "title",
    "Connect a source: source",
  );
  await expect(page.locator(".banner.error")).toHaveCount(0);
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();

  // An unrelated incomplete node must not block a valid scoped run.
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await source.locator(".node-shape").click();
  await inspector
    .getByRole("button", { name: en.runNode, exact: true })
    .click();
  await expect(source.locator(".node-row-count")).toContainText("1 row");
  await expect(page.locator(".banner.error")).toHaveCount(0);
  await page
    .locator(".flow-toolbar")
    .getByRole("button", { name: en.run, exact: true })
    .click();
  await expect(page.locator(".banner.error")).toContainText(
    "Connect input 'source'",
  );
  await expect(sql).toHaveClass(/selected/);
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await source.locator(".node-shape").click();
  await page
    .locator(".banner.error")
    .getByRole("button", { name: "Show node", exact: true })
    .click();
  await expect(sql).toHaveClass(/selected/);
  const input = inspector.getByRole("combobox", {
    name: "source",
    exact: true,
  });
  await input.selectOption("source:result");
  await expect(sql.locator(".missing-input")).toHaveCount(0);
  await expect(page.locator(".banner.error")).toHaveCount(0);
  // Disconnecting again waits for the next run before reporting it.
  await input.selectOption("");
  await expect(sql.locator(".missing-input")).toHaveCount(1);
  await expect(page.locator(".banner.error")).toHaveCount(0);
  await input.selectOption("source:result");
  await expect(sql.locator(".missing-input")).toHaveCount(0);

  // A palette copy of a built-in template has nothing to relink to.
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await sql.locator(".node-shape").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Node actions", exact: true });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", {
      name: "Link to original template",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Remove node", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await source.locator(".node-shape").click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Duplicate node", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const duplicate = (await read()).bundle!.flow.nodes.at(-1)!;
  expect(duplicate.label).toBe("Sample rows");
  expect((await read()).files[`nodes/${duplicate.id}.sql`]).toBe(
    bundle.node_sql["nodes/source.sql"],
  );
  await inspector
    .getByRole("button", { name: "Remove node", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);

  await palette
    .getByRole("button", { name: "Filter", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add linked", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  expect((await read()).bundle!.flow.nodes.at(-1)!.template).toBe("filter");
  await expect(page.locator(".banner.error")).toHaveCount(0);

  for (const [language, labels] of Object.entries({ en, fr, pt, de })) {
    await page.evaluate(
      (language) => localStorage.setItem("duckpad-language", language),
      language,
    );
    await page.reload();
    await expect(
      palette.getByRole("textbox", {
        name: labels.searchNodeTypes,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: labels.searchNodes, exact: true }),
    ).toBeVisible();
    const section = palette.locator("section").filter({
      has: page.getByRole("heading", {
        name: labels.projectTemplates,
        exact: true,
      }),
    });
    await expect(
      section.getByRole("button", { name: "Project summary", exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: labels.filter, exact: true }),
    ).toHaveCount(0);
    const sizes = await palette
      .locator(".palette-item > span:nth-child(2)")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          text: element.textContent,
          fits:
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1,
          whiteSpace: getComputedStyle(element).whiteSpace,
        })),
      );
    expect(sizes.length).toBeGreaterThan(10);
    expect(
      sizes.filter((size) => !size.fits || size.whiteSpace === "nowrap"),
    ).toEqual([]);
  }
  await page.evaluate(() => localStorage.setItem("duckpad-language", "en"));
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: en.fitView, exact: true }).click();
  return id as string;
}
