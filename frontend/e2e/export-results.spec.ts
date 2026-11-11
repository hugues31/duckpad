import { expect, test, type Locator, type Page } from "@playwright/test";
import { createFilterProject } from "./helpers";
import type { Bundle, Run } from "../src/types";

async function exportProject(page: Page, change?: (bundle: Bundle) => void) {
  const project = await createFilterProject(page, (bundle) => {
    bundle.templates.rows =
      "-- @output result\nSELECT range AS amount, 'input' AS input_only FROM range(3);";
    bundle.flow.nodes[1].params.condition = "amount > 0";
    bundle.flow.nodes[2].template = "export_csv";
    bundle.flow.nodes[2].params = { destination: "rows.csv" };
    change?.(bundle);
  });
  await page.goto(`/worktrees/${project.id}/flow?node=output`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  return { ...project, panel };
}

async function runExport(
  page: Page,
  endpoint: string,
  { ancestors = false, status = "success" } = {},
) {
  const response = await page.request.post(`${endpoint}/runs`, {
    data: { environment: "dev", node: "output", ancestors },
  });
  expect(response.ok()).toBe(true);
  const launched: Run = await response.json();
  await expect
    .poll(
      async () => {
        const run: Run = await (
          await page.request.get(`/api/runs/${launched.id}`)
        ).json();
        return run.status;
      },
      { timeout: 30000 },
    )
    .toBe(status);
}

const downloadButton = (panel: Locator) =>
  panel
    .locator(".results-actions")
    .getByRole("button", { name: "Download exported data", exact: true });

test("an export previews its input before it runs, then offers its download and tells its failure", async ({
  page,
}) => {
  const { id, endpoint, read, panel } = await exportProject(page);
  await expect(
    panel.getByRole("tab", { name: "Data", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // A single input is named, without a selector.
  await expect(panel.locator(".results-port")).toHaveText(
    "source ← Filter · result",
  );
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(
    panel.getByText("Ready when you are", { exact: true }),
  ).toBeVisible();
  // The empty preview runs the ancestors only: inspecting inputs must not write the destination.
  const launches: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/runs"))
      launches.push(request.postDataJSON().ancestors);
  });
  await panel
    .getByRole("button", { name: "Run ancestors", exact: true })
    .click();
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2, {
    timeout: 30000,
  });
  await panel.getByRole("tab", { name: /^Columns/ }).click();
  await expect(
    panel.getByRole("button", { name: "amount", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "input_only", exact: true }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  await panel.getByRole("button", { name: "Add a chart", exact: true }).click();
  await expect(page).toHaveURL(/\/code(\?|$)/);
  const saved = await read();
  expect(Object.keys(saved.bundle!.charts!)).toEqual(["filtered:result"]);
  expect(saved.diagnostics).toEqual([]);
  await page.goto(`/worktrees/${id}/flow?node=output`);
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  await expect(panel.locator(".chart-view svg")).toBeVisible();
  await expect(downloadButton(panel)).toBeDisabled();
  await panel.getByRole("tab", { name: /^Log/ }).click();
  await expect(
    panel.getByText("This node has not run in this environment"),
  ).toBeVisible();
  expect(launches).toEqual([true]);

  // Once the export ran, its download is within reach of every tab.
  await runExport(page, endpoint);
  await expect(panel.locator(".log-timeline")).toContainText("source ←");
  await expect(downloadButton(panel)).toBeEnabled();
  // The inspector's Results link returns to the input rows.
  await page
    .locator(".result-summary")
    .getByRole("button", { name: "Results", exact: true })
    .click();
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
  await expect(downloadButton(panel)).toBeEnabled();

  // A failed export tells so above the rows it received.
  const failing = await read();
  failing.bundle!.templates.export_csv =
    failing.bundle!.templates.export_csv.replace(
      "COPY {{ source }}",
      "COPY (SELECT error('Export refused') FROM {{ source }})",
    );
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: failing.revision, bundle: failing.bundle },
      })
    ).ok(),
  ).toBe(true);
  await runExport(page, endpoint, { status: "partial_failure" });
  await expect(panel.locator(".execution-error")).toContainText(
    "Export refused",
  );
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
});

test("export preview switches inputs and follows reconnections and environments", async ({
  page,
}) => {
  const { endpoint, read, panel } = await exportProject(page, (bundle) => {
    bundle.templates.multiple = bundle.templates.export_csv.replace(
      "-- @input source",
      "-- @input source\n-- @input extra",
    );
    bundle.flow.nodes[2].template = "multiple";
    bundle.flow.edges.push({
      id: "extra",
      source: "rows",
      sourceHandle: "result",
      target: "output",
      targetHandle: "extra",
    });
  });
  await runExport(page, endpoint, { ancestors: true });
  await page.reload();
  const picker = panel.getByRole("combobox", { name: "Inputs", exact: true });
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
  await picker.selectOption("input:extra");
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(3);
  await picker.selectOption("input:source");
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);

  const snapshot = await read();
  snapshot.bundle!.flow.edges.find((edge) => edge.id === "second")!.source =
    "rows";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBe(true);
  // The open panel must stop showing the old source without a reload.
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(3);
  await page.getByLabel("Environment", { exact: true }).selectOption("prod");
  await expect(
    panel.getByText("Ready when you are", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(0);
  await page.getByLabel("Environment", { exact: true }).selectOption("dev");
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(3);

  const disconnected = await read();
  disconnected.bundle!.flow.edges = disconnected.bundle!.flow.edges.filter(
    (edge) => edge.target !== "output",
  );
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: disconnected.revision, bundle: disconnected.bundle },
      })
    ).ok(),
  ).toBe(true);
  await expect(panel.getByRole("tab")).toHaveText(["Tests", "Log"]);
  await expect(panel.locator(".data-table")).toHaveCount(0);
});
