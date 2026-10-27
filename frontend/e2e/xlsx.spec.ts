import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";

test.use({ actionTimeout: 10000 });

test("configure Excel, upload a worksheet and export it through the canvas", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const file = testInfo.outputPath("workbook.xlsx");
  execFileSync("../.venv/bin/python", ["../tests/xlsx_fixture.py", file]);
  await signIn(page);
  await openInstanceSettings(page, "Connections");
  await page
    .getByRole("button", { name: "New connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("ID", { exact: true }).fill("xlsx_browser");
  await dialog.getByLabel("Name", { exact: true }).fill("Browser workbooks");
  await dialog
    .getByRole("combobox", { name: /Connector/ })
    .selectOption("xlsx");
  await expect(dialog.getByLabel("root", { exact: true })).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);

  const worktree = await (
    await page.request.post("/api/projects", { data: { name: "XLSX browser" } })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  try {
    expect(
      (
        await page.request.put(
          `/api/projects/${worktree.project}/connections`,
          {
            data: { connections: ["xlsx_browser"] },
          },
        )
      ).ok(),
    ).toBeTruthy();
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.getByRole("button", { name: "Load XLSX", exact: true }).click();
    const inspector = page.locator(".inspector");
    await inspector
      .getByRole("combobox", { name: /connection/ })
      .selectOption("xlsx_browser");
    const upload = inspector.getByLabel("Upload file", { exact: true });
    await expect(upload).toHaveAttribute("accept", /\.xlsx/);
    await upload.setInputFiles(file);
    await expect(inspector.getByRole("textbox", { name: /file/ })).toHaveValue(
      /workbook\.xlsx$/,
    );
    await inspector.getByRole("textbox", { name: /sheet/ }).fill("Orders");
    await inspector
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(async () => {
        const snapshot = await (await page.request.get(endpoint)).json();
        return snapshot.bundle.flow.nodes[0]?.params.sheet;
      })
      .toBe("Orders");
    let snapshot = await (await page.request.get(endpoint)).json();
    const source = snapshot.bundle.flow.nodes[0].id;

    await page
      .getByRole("button", { name: "Export XLSX", exact: true })
      .click();
    await inspector
      .getByLabel("source", { exact: true })
      .selectOption(`${source}:result`);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(endpoint)).json()).bundle.flow.edges
            .length,
      )
      .toBe(1);
    await inspector
      .getByRole("combobox", { name: /connection/ })
      .selectOption("xlsx_browser");
    await inspector
      .getByRole("textbox", { name: /sheet/ })
      .fill("Exported orders");
    await inspector
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(async () => {
        const current = await (await page.request.get(endpoint)).json();
        const parameters = current.bundle.flow.nodes.find(
          (node: any) => node.template === "export_xlsx",
        )?.params;
        return [parameters?.connection, parameters?.sheet];
      })
      .toEqual(["xlsx_browser", "Exported orders"]);
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    const run = await (await launched).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
        { timeout: 30000 },
      )
      .toBe("success");
    const preview = await (
      await page.request.get(`${endpoint}/preview/${source}?environment=dev`)
    ).json();
    expect(preview.rows.map((row: any) => row.values[2])).toEqual([
      12.5, 20, 7.5,
    ]);

    // Re-read the exported workbook through the same isolated API worker.
    snapshot = await (await page.request.get(endpoint)).json();
    snapshot.bundle.flow.nodes.push({
      id: "roundtrip",
      template: "load_xlsx",
      params: {
        connection: "xlsx_browser",
        file: "export.xlsx",
        sheet: "Exported orders",
      },
      position: { x: 500, y: 300 },
    });
    expect(
      (
        await page.request.put(endpoint, {
          data: { revision: snapshot.revision, bundle: snapshot.bundle },
        })
      ).ok(),
    ).toBeTruthy();
    const reread = await (
      await page.request.post(`${endpoint}/runs`, {
        data: { environment: "dev", node: "roundtrip" },
      })
    ).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${reread.id}`)).json())
            .status,
      )
      .toBe("success");
    const exported = await (
      await page.request.get(`${endpoint}/preview/roundtrip?environment=dev`)
    ).json();
    expect(exported.rows.map((row: any) => row.values)).toEqual(
      preview.rows.map((row: any) => row.values),
    );
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    await page.request.delete("/api/catalog/connection/xlsx_browser");
  }
});
