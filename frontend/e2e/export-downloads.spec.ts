import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signIn } from "./helpers";

test("download a full CSV export and keep project ZIP separate", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Export downloads" },
    })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  try {
    const snapshot = await (await page.request.get(endpoint)).json();
    snapshot.bundle.templates.rows =
      "-- @kind source\n-- @output result\nSELECT range AS id, 'item;' || range AS label FROM range(1003);";
    snapshot.bundle.flow.nodes = [
      {
        id: "source",
        label: "Source rows",
        template: "rows",
        params: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "export",
        label: "CSV file",
        template: "export_csv",
        params: {
          destination: "browser-report.csv",
          delimiter: ";",
          header: false,
        },
        position: { x: 300, y: 0 },
      },
      {
        id: "oracle",
        label: "Oracle destination",
        template: "export_oracle",
        params: {},
        position: { x: 300, y: 200 },
      },
    ];
    snapshot.bundle.flow.edges = [
      {
        id: "edge",
        source: "source",
        sourceHandle: "result",
        target: "export",
        targetHandle: "source",
      },
    ];
    expect(
      (
        await page.request.put(endpoint, {
          data: { revision: snapshot.revision, bundle: snapshot.bundle },
        })
      ).ok(),
    ).toBeTruthy();
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.locator('.react-flow__node[data-id="export"]').click();
    const panel = page.getByRole("region", {
      name: "Download exported data",
      exact: true,
    });
    const downloadButton = panel.getByRole("button", {
      name: "Download exported data",
      exact: true,
    });
    await expect(downloadButton).toBeDisabled();
    await expect(panel).toContainText("Run this export successfully");
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .locator(".inspector")
      .getByRole("button", { name: "Run with ancestors", exact: true })
      .click();
    const run = await (await launched).json();
    await expect(downloadButton).toBeEnabled({ timeout: 30000 });
    await expect(panel).toContainText(run.id);
    const pendingDownload = page.waitForEvent("download");
    await downloadButton.click();
    const file = await pendingDownload;
    expect(file.suggestedFilename()).toBe("browser-report.csv");
    const bytes = await readFile((await file.path())!);
    const rows = bytes.toString("utf8").trim().split("\n");
    expect(rows).toHaveLength(1003);
    expect(rows[0]).toBe('0;"item;0"');
    expect(rows.at(-1)).toBe('1002;"item;1002"');
    await page.route("**/exports/export/download?*", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        headers: { "X-Frame-Options": "SAMEORIGIN" },
        body: JSON.stringify({
          error: "Exported file is unavailable. Run the export again.",
        }),
      }),
    );
    await downloadButton.click();
    await expect(panel.getByRole("alert")).toContainText(
      "Exported file is unavailable",
    );
    await page.unroute("**/exports/export/download?*");
    const retriedDownload = page.waitForEvent("download");
    await downloadButton.click();
    expect((await retriedDownload).suggestedFilename()).toBe(
      "browser-report.csv",
    );

    await page.getByLabel("Environment", { exact: true }).selectOption("prod");
    await expect(downloadButton).toBeDisabled();
    await expect(panel).toContainText("Run this export successfully");
    await page.getByLabel("Environment", { exact: true }).selectOption("dev");
    await expect(downloadButton).toBeEnabled();
    await page.locator('.react-flow__node[data-id="oracle"]').click();
    await expect(panel).toHaveCount(0);
    await page.locator('.react-flow__node[data-id="export"]').click();
    await expect(downloadButton).toBeEnabled();
    await page
      .locator(".inspector")
      .getByRole("textbox", { name: /delimiter/ })
      .fill(",");
    await page
      .locator(".inspector")
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(panel).toContainText("Inputs or settings have changed");
    await expect(downloadButton).toBeDisabled();

    await expect(page.locator(".save-status")).toHaveText("All changes saved");
    await page.getByRole("link", { name: "Code", exact: true }).click();
    const pendingZip = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download project ZIP", exact: true })
      .click();
    const zip = await pendingZip;
    expect(zip.suggestedFilename()).toBe("duckpad-project.zip");
    const archive = await readFile((await zip.path())!);
    expect(archive.subarray(0, 4).toString("hex")).toBe("504b0304");
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
  }
});
