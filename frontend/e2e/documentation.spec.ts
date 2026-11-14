import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };

// The example runs before its results are documented.
test.setTimeout(90000);

/** Open the Documentation tab of a new example project, once it has run in dev. */
async function documentedExample(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const run = await (
    await page.request.post(`/api/worktrees/${worktree.id}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 60000 },
    )
    .toBe("success");
  await page.goto(`/worktrees/${worktree.id}/documentation?environment=dev`);
  const documentation = page.locator(".documentation-page");
  await expect(documentation.getByRole("heading", { level: 1 })).toHaveText(
    "Northstar analytics",
  );
  return { worktree, documentation };
}

/** Whether an element is inside the visible part of the scrolled document. */
const inView = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const root = document.querySelector(".documentation-page")!;
    const frame = root.getBoundingClientRect();
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return box.top >= frame.top - 1 && box.top < frame.bottom;
  }, selector);

test("the project reads as a document with an outline, its pipeline and every node", async ({
  page,
}) => {
  const { worktree, documentation } = await documentedExample(page);
  await expect(documentation.locator(".doc-lede")).toHaveText(
    "From raw orders to explainable revenue",
  );
  await expect(documentation.locator(".doc-stats li")).toHaveText([
    "3Sources",
    "7Transformations",
    "2Exports",
    "8Data tests",
    "3Variables",
    "1Connections",
  ]);
  // The overview is read first; its own headings sit under the page's.
  await expect(
    documentation.getByRole("heading", {
      level: 3,
      name: "Northstar · Revenue operations",
    }),
  ).toBeVisible();
  await expect(documentation.locator("textarea")).toHaveCount(0);

  // Nodes follow the pipeline, grouped by role.
  const outline = documentation.getByRole("navigation", { name: "Contents" });
  await expect(outline.locator("> ul > li > a")).toHaveText([
    "Overview",
    "Pipeline",
    "Sources3",
    "Transformations7",
    "Exports2",
    "Variables3",
    "Data tests8",
    "Connections1",
  ]);
  await expect(
    documentation.locator("#doc-transformations > .doc-node h3"),
  ).toHaveText([
    "Reporting period",
    "Enrich orders",
    "Paid orders",
    "Customer reach",
    "Net amounts",
    "Regional revenue",
    "High-value orders",
  ]);

  // The outline leads to a section and follows the reading position.
  await outline.getByRole("link", { name: "Variables 3" }).click();
  await expect.poll(() => inView(page, "#doc-variables")).toBe(true);
  await expect(
    outline.getByRole("link", { name: "Variables 3" }),
  ).toHaveAttribute("aria-current", "location");
  await expect(page).toHaveURL(/\/documentation\?environment=dev$/);
  const variables = documentation.locator("#doc-variables");
  await expect(
    variables.getByRole("row", { name: /high_value_threshold/ }),
  ).toContainText("Minimum order amount kept by the High-value orders report.");
  await expect(
    variables.getByRole("row", { name: /report_month/ }),
  ).toContainText("Computed from node Reporting period");

  // The drawing of the pipeline leads to each node.
  const diagram = documentation.locator(".doc-diagram");
  await expect(diagram.locator("a")).toHaveCount(12);
  await expect(diagram.locator(".doc-diagram-edge")).toHaveCount(11);
  await diagram.locator("a", { hasText: "Paid orders" }).click();
  await expect.poll(() => inView(page, "#doc-node-validated")).toBe(true);
  await expect(
    outline.getByRole("link", { name: "Paid orders", exact: true }),
  ).toHaveAttribute("aria-current", "location");

  // A node tells what it reads, feeds, checks and produces.
  const paid = documentation.locator("#doc-node-validated");
  await expect(paid.locator(".doc-node-kind")).toHaveText(
    "Transform · Validated orders",
  );
  await expect(paid.locator(".doc-facts")).toContainText(
    "Reads fromEnrich orders",
  );
  await expect(paid.locator(".doc-variable")).toHaveText("review_threshold");
  await expect(paid.locator(".doc-tests li")).toHaveText([
    "order_id_uniqueOK",
    "amount_positiveOK",
    "large_order_reviewWarningFailing rows: 10",
  ]);
  const orders = paid.locator(".doc-output").first();
  await expect(orders.locator("summary")).toContainText("107 rows");
  await expect(orders.locator("summary")).toContainText("9 columns");
  await expect(orders.locator(".doc-saved")).toHaveText("Orders to review");
  await expect(
    documentation
      .locator("#doc-node-orders")
      .getByRole("row", { name: /amount/ }),
  ).toContainText("Gross order amount in EUR before refunds.");

  // A component shows the nodes it contains; their columns unfold on request.
  const report = documentation.locator("#doc-node-report");
  await expect(report.locator(".doc-node-kind").first()).toHaveText(
    "Component · Regional report",
  );
  await expect(report.locator(".doc-saved").first()).toHaveText(
    "Revenue by regionNet and gross revenue",
  );
  const rank = report.locator("#doc-node-report--rank");
  await expect(rank.getByRole("heading")).toHaveText("Rank regions");
  await expect(rank.getByRole("table")).toBeHidden();
  await rank.locator("summary").click();
  await expect(rank.getByRole("row", { name: /net_share/ })).toContainText(
    "Percentage of total net revenue for this region",
  );

  const accessibility = await new AxeBuilder({ page })
    .include(".documentation-page")
    .analyze();
  expect(accessibility.violations).toEqual([]);

  // Nothing overflows on a narrow screen, where the outline gives way.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(outline).toBeHidden();
  expect(
    await documentation.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1512, height: 982 });

  // A node opens in the flow.
  await paid.getByRole("link", { name: "Open in Flow: Paid orders" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/worktrees/${worktree.id}/flow\\?environment=dev&node=validated`,
    ),
  );
  await expect(
    page.locator(".react-flow__node.selected .node-title"),
  ).toHaveText("Paid orders");
});

test("Export PDF prints the whole document, unfolded and without the application", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const { documentation } = await documentedExample(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // The browser's dialog cannot be driven: record what it would print.
  await page.evaluate(() => {
    const state = window as unknown as { printed: string[] };
    state.printed = [];
    window.print = () => {
      window.dispatchEvent(new Event("beforeprint"));
      state.printed.push(
        [
          document.title,
          document.querySelectorAll(".doc-article details:not([open])").length,
          document.querySelector(".doc-print-meta")!.textContent,
        ].join("|"),
      );
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  await documentation
    .getByRole("button", { name: "Edit overview", exact: true })
    .click();
  await documentation.locator(".project-documentation").fill("# Draft title");
  await documentation
    .getByRole("button", { name: "Export PDF", exact: true })
    .click();
  const [printed] = await page.evaluate(
    () => (window as unknown as { printed: string[] }).printed,
  );
  // The PDF is named after the project, every section is unfolded.
  expect(printed).toMatch(
    /^Northstar analytics - Documentation\|0\|Branch main {2}· {2}Commit [0-9a-f]{8} {2}· {2}Environment dev {2}· {2}Generated on /,
  );
  await expect(page).toHaveTitle("Documentation · Duckpad");
  // The editor comes back after printing, with its draft.
  await expect(documentation.locator(".project-documentation")).toHaveValue(
    "# Draft title",
  );

  // On paper: only the document, on white, whatever the theme.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.locator(".flow-toolbar")).toBeHidden();
  await expect(documentation.locator(".doc-outline")).toBeHidden();
  await expect(
    documentation.getByRole("button", { name: "Export PDF" }),
  ).toBeHidden();
  await expect(documentation.locator(".doc-print-meta")).toBeVisible();
  expect(
    await documentation.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.overflowY, style.backgroundColor];
    }),
  ).toEqual(["visible", "rgb(255, 255, 255)"]);
  const pdf = await page.pdf({ preferCSSPageSize: true });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  // Sixteen A4 pages or so: the whole reference, not one screen.
  expect(
    pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)!.length,
  ).toBeGreaterThan(8);
  await page.emulateMedia({ media: null });
});

test("the document is translated and adapts to a project without nodes", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: "Blank" } })
  ).json();
  await page.goto(`/worktrees/${project.id}/documentation`);
  const documentation = page.locator(".documentation-page");
  await expect(documentation.getByRole("heading", { level: 1 })).toHaveText(
    "Blank",
  );
  await expect(documentation.locator(".doc-empty")).toHaveText([
    /^No overview yet\./,
    /^This project has no nodes yet\./,
  ]);
  await expect(
    documentation.getByRole("navigation", { name: "Contents" }).locator("a"),
  ).toHaveText(["Overview"]);
  await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
  await page.reload();
  await expect(
    documentation.getByRole("button", { name: fr.docExport, exact: true }),
  ).toBeVisible();
  await expect(
    documentation.getByRole("heading", { name: fr.docOverview, exact: true }),
  ).toBeVisible();
  await page.evaluate(() => localStorage.removeItem("duckpad-language"));
});
