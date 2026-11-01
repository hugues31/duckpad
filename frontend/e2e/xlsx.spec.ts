import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.use({ actionTimeout: 10000 });

test("upload a worksheet and export it as project files through the canvas", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const file = testInfo.outputPath("workbook.xlsx");
  execFileSync("../.venv/bin/python", ["../tests/xlsx_fixture.py", file]);
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", { data: { name: "XLSX browser" } })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  try {
    // Duckpad's container image links excel. Other DuckDB builds, such as the
    // PyPI wheel used in CI, need it enabled in the project; the test server
    // installs it.
    const available = await (
      await page.request.get(`${endpoint}/extensions`)
    ).json();
    if (
      !available.core_extensions.find(
        (extension: { name: string }) => extension.name === "excel",
      )?.built_in
    ) {
      const current = await (await page.request.get(endpoint)).json();
      current.bundle.extensions = { excel: { source: "core", enabled: true } };
      expect(
        (
          await page.request.put(endpoint, {
            data: { revision: current.revision, bundle: current.bundle },
          })
        ).ok(),
      ).toBeTruthy();
    }
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.getByRole("button", { name: "Load XLSX", exact: true }).click();
    const inspector = page.locator(".inspector");
    const location = inspector.getByRole("combobox", {
      name: "Location",
      exact: true,
    });
    await expect(location).toHaveValue("");
    await expect(location.locator("option")).toHaveText(["Project files"]);
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
    await expect(location).toHaveValue("");
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
          (node: any) => (node.template || node.origin) === "export_xlsx",
        )?.params;
        return [parameters?.connection ?? "", parameters?.sheet];
      })
      .toEqual(["", "Exported orders"]);
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

    // The export's results panel opens on its Log, which offers the download.
    const downloadButton = page
      .getByRole("region", { name: "Results", exact: true })
      .getByRole("button", { name: "Download exported data", exact: true });
    await expect(downloadButton).toBeEnabled();
    const pendingDownload = page.waitForEvent("download");
    await downloadButton.click();
    const downloaded = await pendingDownload;
    expect(downloaded.suggestedFilename()).toBe("export.xlsx");
    const bytes = await readFile((await downloaded.path())!);
    snapshot = await (await page.request.get(endpoint)).json();
    const exportedFile = await page.request.get(
      `${endpoint}/exports/${snapshot.bundle.flow.nodes.find((node: any) => (node.template || node.origin) === "export_xlsx")!.id}/download?run=${run.id}&environment=dev`,
    );
    expect(exportedFile.ok()).toBeTruthy();
    expect(bytes.equals(await exportedFile.body())).toBeTruthy();

    // Re-read the exported workbook through the same isolated API worker.
    // Relative sources resolve under the project's uploads, so name the export by its path.
    const exportNode = snapshot.bundle.flow.nodes.find(
      (node: any) => (node.template || node.origin) === "export_xlsx",
    )!.id;
    const executed = await (
      await page.request.get(`/api/runs/${run.id}`)
    ).json();
    const exportPath = executed.nodes[exportNode].statements.find(
      (statement: any) => statement.export_file,
    ).export_file.path;
    expect(exportPath).toMatch(/export\.xlsx$/);
    snapshot = await (await page.request.get(endpoint)).json();
    snapshot.bundle.flow.nodes.push({
      id: "roundtrip",
      template: "load_xlsx",
      params: {
        file: exportPath,
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
  }
});
